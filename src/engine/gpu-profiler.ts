/** Opt-in timestamps; absent support is reported, never replaced with fake GPU time. */
export class GPUProfiler {
  private queries: GPUQuerySet;
  private resolve: GPUBuffer;
  private readback: GPUBuffer;
  private names: string[] = [];
  constructor(private device: GPUDevice) {
    this.queries = device.createQuerySet({ type: "timestamp", count: 128 });
    this.resolve = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readback = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }
  begin() {
    this.names = [];
  }
  pass(name: string): GPUComputePassTimestampWrites {
    const index = this.names.length * 2;
    if (index >= 128)
      throw new Error("Profiling batch exceeds timestamp capacity");
    this.names.push(name);
    return {
      querySet: this.queries,
      beginningOfPassWriteIndex: index,
      endOfPassWriteIndex: index + 1,
    };
  }
  finish(encoder: GPUCommandEncoder) {
    const n = this.names.length * 2;
    if (n) {
      encoder.resolveQuerySet(this.queries, 0, n, this.resolve, 0);
      encoder.copyBufferToBuffer(this.resolve, 0, this.readback, 0, n * 8);
    }
  }
  async read() {
    await this.readback.mapAsync(GPUMapMode.READ);
    const values = new BigUint64Array(this.readback.getMappedRange());
    const result: Record<string, number> = {};
    try {
      this.names.forEach((name, i) => {
        result[name] =
          (result[name] ?? 0) + Number(values[i * 2 + 1] - values[i * 2]) / 1e6;
      });
    } finally {
      this.readback.unmap();
    }
    return result;
  }
  destroy() {
    this.queries.destroy();
    this.resolve.destroy();
    this.readback.destroy();
  }
}
