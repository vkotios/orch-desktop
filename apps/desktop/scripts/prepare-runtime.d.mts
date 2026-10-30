export interface PrepareRuntimeOptions {
  manifestPath?: string;
  sourceRoot?: string;
  outputDir?: string;
  fetchImpl?: typeof fetch;
}
export interface PrepareRuntimeResult {
  version: string;
  outputDir: string;
}
export declare function prepareRuntime(options?: PrepareRuntimeOptions): Promise<PrepareRuntimeResult>;
