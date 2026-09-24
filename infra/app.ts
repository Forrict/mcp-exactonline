import { Annotations, App, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  type IMetric,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Rule, RuleTargetInput, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, FunctionUrlAuthType, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Trigger } from "aws-cdk-lib/triggers";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

/**
 * Exact Online MCP server for Claude: one Lambda behind a public Function URL,
 * with config and OAuth tokens in a single Secrets Manager secret.
 *
 * Settings via CDK context (`cdk deploy -c key=value`):
 *   exactRegion   (default "nl")
 *   exactDivision (default: the user's current division)
 *   readOnly      ("true" hides tools that create or modify data)
 *   alarmEmail    (optional: e-mail address for security/error alarms)
 */
class ExactMcpStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ctx = (key: string, fallback = ""): string =>
      String(this.node.tryGetContext(key) ?? fallback);

    // CloudFormation generates SIGNING_KEY once; the function adds the OAuth
    // client credentials and tokens, you add the Exact fields in the console.
    // Do not change generateSecretString: that would regenerate the secret
    // value and wipe everything stored in it.
    const secret = new Secret(this, "Secret", {
      description: "Exact Online MCP server: credentials, signing key and OAuth tokens",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          EXACT_CLIENT_ID: "",
          EXACT_CLIENT_SECRET: "",
          ALLOWED_EXACT_USER: "",
        }),
        generateStringKey: "SIGNING_KEY",
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    const logGroup = new LogGroup(this, "Logs", {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, "McpFunction", {
      entry: fileURLToPath(new URL("../src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      logGroup,
      environment: {
        EXACT_SECRET_ID: secret.secretArn,
        EXACT_REGION: ctx("exactRegion", "nl"),
        EXACT_DIVISION: ctx("exactDivision"),
        EXACT_READ_ONLY: ctx("readOnly", "false"),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node22",
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });
    secret.grantRead(fn);
    secret.grantWrite(fn);

    // Claude connects from the internet; the MCP endpoint requires an OAuth
    // access token issued by the function itself (see src/auth/oauthServer.ts).
    const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    // After each deploy that changes the function, let it fill in the generated
    // OAuth client credentials so they are ready to copy into Claude.
    new Trigger(this, "SetupTrigger", { handler: fn, executeAfter: [fn, secret] });
    // The trigger invokes a function version with an IAM-role grant; the
    // public Function URL permissions only concern the unqualified function.
    Annotations.of(fn).acknowledgeWarning(
      "@aws-cdk/aws-lambda:addPermissionsToVersionOrAlias",
      "Only the setup trigger invokes the version, via its own IAM role."
    );

    // Rotate the Exact refresh token weekly so it never expires between uses.
    new Rule(this, "KeepAlive", {
      schedule: Schedule.rate(Duration.days(7)),
      targets: [new LambdaFunction(fn, { event: RuleTargetInput.fromObject({ keepalive: true }) })],
    });

    new CfnOutput(this, "FunctionUrl", {
      value: url.url,
      description:
        "Claude connector URL: <FunctionUrl>mcp. Exact redirect URI: <FunctionUrl>oauth/callback.",
    });
    new CfnOutput(this, "SecretConsoleUrl", {
      value: `https://${this.region}.console.aws.amazon.com/secretsmanager/secret?name=${secret.secretName}&region=${this.region}`,
      description: "Fill in the Exact fields and copy the OAuth client credentials here.",
    });

    // Security and health alarms (metric filters count the markers the
    // function logs; see logSecurityEvent in src/auth/oauthServer.ts).
    const countOf = (marker: string): IMetric =>
      new MetricFilter(this, `${marker}Filter`, {
        logGroup,
        filterPattern: FilterPattern.literal(`"${marker}"`),
        metricNamespace: "ExactOnlineMcp",
        metricName: marker,
        metricValue: "1",
      }).metric({ statistic: "Sum", period: Duration.minutes(5) });

    const alarmDefaults = {
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    };
    const alarms = [
      new Alarm(this, "AuthFailuresAlarm", {
        alarmDescription: "Many rejected requests or tokens on the Exact Online MCP server.",
        metric: countOf("AUTH_FAILURE"),
        threshold: 10,
        ...alarmDefaults,
      }),
      new Alarm(this, "LoginRejectedAlarm", {
        alarmDescription: "Someone logged in with an Exact Online user that is not allowed.",
        metric: countOf("LOGIN_REJECTED"),
        threshold: 1,
        ...alarmDefaults,
      }),
      new Alarm(this, "ErrorsAlarm", {
        alarmDescription: "The Exact Online MCP function failed (e.g. keep-alive token refresh).",
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        ...alarmDefaults,
      }),
    ];

    const alarmEmail = ctx("alarmEmail");
    if (alarmEmail) {
      const topic = new Topic(this, "AlarmTopic");
      topic.addSubscription(new EmailSubscription(alarmEmail));
      for (const alarm of alarms) alarm.addAlarmAction(new SnsAction(topic));
    }
  }
}

const app = new App();
new ExactMcpStack(app, "ExactOnlineMcp", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
