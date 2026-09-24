import { App, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Rule, RuleTargetInput, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Architecture, FunctionUrlAuthType, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

/**
 * Exact Online MCP server for Claude: one Lambda behind a public Function URL,
 * with config and OAuth tokens in a single, pre-existing Secrets Manager secret.
 *
 * Settings via CDK context (`cdk deploy -c key=value`):
 *   secretName    (default "mcp-exactonline")
 *   exactRegion   (default "nl")
 *   exactDivision (default: the user's current division)
 *   readOnly      ("true" hides tools that create or modify data)
 */
class ExactMcpStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ctx = (key: string, fallback = ""): string =>
      String(this.node.tryGetContext(key) ?? fallback);

    // Created by hand (see README) so a deploy never overwrites stored tokens.
    const secret = Secret.fromSecretNameV2(this, "Secret", ctx("secretName", "mcp-exactonline"));

    const fn = new NodejsFunction(this, "McpFunction", {
      entry: fileURLToPath(new URL("../src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      logGroup: new LogGroup(this, "Logs", {
        retention: RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        EXACT_SECRET_ID: secret.secretName,
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

    // Claude connects from the internet; access is guarded by MCP_ACCESS_KEY.
    const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    // Rotate the Exact refresh token weekly so it never expires between uses.
    new Rule(this, "KeepAlive", {
      schedule: Schedule.rate(Duration.days(7)),
      targets: [new LambdaFunction(fn, { event: RuleTargetInput.fromObject({ keepalive: true }) })],
    });

    new CfnOutput(this, "FunctionUrl", {
      value: url.url,
      description:
        "Claude connector URL: <FunctionUrl>mcp/<MCP_ACCESS_KEY>. Exact redirect URI: <FunctionUrl>oauth/callback.",
    });
  }
}

const app = new App();
new ExactMcpStack(app, "ExactOnlineMcp", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
