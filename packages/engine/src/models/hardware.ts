import { totalmem, freemem, cpus } from 'node:os';
import { statfs } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import type { GpuInfo, HardwareProfile } from '@queryload/shared';
import type { Logger } from '../logging/logger.js';

const GB = 1024 * 1024 * 1024;

/**
 * Detects the machine's RAM, GPU/VRAM, and free disk (D38). Runs entirely
 * locally via OS calls and CLI probes — never the network. Results feed the
 * eligibility gate and the "which machine" model filter.
 */
export class HardwareProbe {
  private cached: HardwareProfile | null = null;

  constructor(
    private readonly modelsDir: string,
    private readonly logger: Logger,
  ) {}

  async profile(refresh = false): Promise<HardwareProfile> {
    if (this.cached && !refresh) return this.cached;
    const [freeDiskGB, gpus] = await Promise.all([this.freeDisk(), Promise.resolve(this.detectGpus())]);
    const profile: HardwareProfile = {
      totalRamGB: round(totalmem() / GB),
      freeRamGB: round(freemem() / GB),
      gpus,
      freeDiskGB: round(freeDiskGB),
      cpuThreads: cpus().length,
    };
    this.cached = profile;
    this.logger.info(
      { ramGB: profile.totalRamGB, gpus: profile.gpus.length, diskGB: profile.freeDiskGB },
      'hardware profiled',
    );
    return profile;
  }

  private async freeDisk(): Promise<number> {
    try {
      const st = await statfs(this.modelsDir);
      return (st.bavail * st.bsize) / GB;
    } catch {
      return 0;
    }
  }

  private detectGpus(): GpuInfo[] {
    const nvidia = this.detectNvidia();
    if (nvidia.length > 0) return nvidia;
    return this.detectViaCim();
  }

  /** Accurate NVIDIA VRAM via nvidia-smi (present when CUDA is installed). */
  private detectNvidia(): GpuInfo[] {
    try {
      const out = spawnSync(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      if (out.status !== 0 || !out.stdout) return [];
      return out.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [name, mb] = line.split(',').map((s) => s.trim());
          const vramGB = mb ? round(Number(mb) / 1024) : null;
          return { name: name ?? 'NVIDIA GPU', vramGB };
        });
    } catch {
      return [];
    }
  }

  /**
   * Fallback: Windows CIM. Name is reliable; AdapterRAM under-reports VRAM
   * above ~4GB (32-bit field), so we treat it as a floor, not a truth.
   */
  private detectViaCim(): GpuInfo[] {
    if (process.platform !== 'win32') return [];
    try {
      const script =
        'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }';
      const out = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 },
      );
      if (out.status !== 0 || !out.stdout) return [];
      return out.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [name, ram] = line.split('|');
          const bytes = Number(ram);
          const vramGB = Number.isFinite(bytes) && bytes > 0 ? round(bytes / GB) : null;
          return { name: (name ?? 'GPU').trim(), vramGB };
        });
    } catch {
      return [];
    }
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
