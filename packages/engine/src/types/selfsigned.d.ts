/**
 * Minimal ambient types for `selfsigned` (which ships no type declarations).
 * Only the surface QueryLoad uses is declared, kept strict.
 */
declare module 'selfsigned' {
  export interface SelfsignedAttribute {
    name?: string;
    shortName?: string;
    value: string;
    type?: string;
  }

  export interface SelfsignedExtension {
    name: string;
    [key: string]: unknown;
  }

  export interface SelfsignedOptions {
    days?: number;
    keySize?: number;
    algorithm?: 'sha256' | 'sha1';
    extensions?: SelfsignedExtension[];
  }

  export interface SelfsignedResult {
    private: string;
    public: string;
    cert: string;
    fingerprint?: string;
  }

  export function generate(
    attrs?: SelfsignedAttribute[],
    options?: SelfsignedOptions,
  ): SelfsignedResult;

  const _default: { generate: typeof generate };
  export default _default;
}
