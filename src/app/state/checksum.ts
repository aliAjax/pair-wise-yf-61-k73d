/** 生成固件包校验码（演示用 sha256 风格随机串） */
export function generateChecksum(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}
