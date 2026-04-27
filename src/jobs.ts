import { randomUUID } from "crypto";
import {
  ContainerJobConfig,
  ContainerJobResult,
  ContainerRuntimeInfo,
} from "./types";
import { execRuntime, execRuntimeLong } from "./runtime";
import { volumeArg } from "./containers";

export async function runJob(
  runtime: ContainerRuntimeInfo,
  config: ContainerJobConfig,
): Promise<ContainerJobResult> {
  const id = randomUUID();
  const jobName = `sk-job-${id.slice(0, 8)}`;
  const createdAt = new Date().toISOString();

  const result: ContainerJobResult = {
    id,
    status: "pending",
    image: config.image,
    command: config.command,
    label: config.label,
    log: [],
    createdAt,
    runtime: runtime.runtime,
  };

  try {
    const inspectResult = await execRuntime(runtime, [
      "image",
      "inspect",
      config.image,
    ]);
    if (inspectResult.exitCode !== 0) {
      result.status = "pulling";
      config.onProgress?.(`Pulling ${config.image}...`);
      const pullResult = await execRuntimeLong(
        runtime,
        ["pull", config.image],
        config.onProgress,
        config.timeout ? config.timeout * 1000 : 300000,
      );
      if (pullResult.exitCode !== 0) {
        result.status = "failed";
        result.error = `Pull failed: ${pullResult.log.slice(-3).join("\n")}`;
        result.log = pullResult.log;
        return result;
      }
    }

    result.status = "running";
    result.startedAt = new Date().toISOString();

    const args = ["run", "--rm", "--name", jobName];

    if (config.inputs) {
      for (const [containerPath, hostPath] of Object.entries(config.inputs)) {
        args.push("-v", volumeArg(hostPath, containerPath, runtime, true));
      }
    }

    if (config.outputs) {
      for (const [containerPath, hostPath] of Object.entries(config.outputs)) {
        args.push("-v", volumeArg(hostPath, containerPath, runtime));
      }
    }

    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    args.push(config.image, ...config.command);

    const runResult = await execRuntimeLong(
      runtime,
      args,
      config.onProgress,
      config.timeout ? config.timeout * 1000 : 600000,
    );

    result.exitCode = runResult.exitCode;
    result.log = runResult.log;
    result.completedAt = new Date().toISOString();
    result.status = runResult.exitCode === 0 ? "completed" : "failed";

    if (runResult.exitCode !== 0) {
      result.error = `Container exited with code ${runResult.exitCode}`;
    }
  } catch (err) {
    result.status = "failed";
    result.error = err instanceof Error ? err.message : String(err);
    result.completedAt = new Date().toISOString();

    await execRuntime(runtime, ["rm", "-f", jobName]).catch(() => {});
  }

  return result;
}
