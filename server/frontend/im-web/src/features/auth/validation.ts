export function validateUsername(username: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(username) ? null : '账号需为 3–64 位字母、数字或 . _ -，且以字母或数字开头。';
}
export function validatePassword(password: string): string | null {
  const bytes = new TextEncoder().encode(password).length;
  return bytes >= 8 && bytes <= 72 ? null : '密码需为 8–72 个 UTF-8 字节。';
}
export function validateName(name: string): string | null {
  return name.trim() && [...name].length <= 100 ? null : '显示名称需为 1–100 个字符。';
}
export function validateCredentials(username: string, password: string, name?: string): string | null {
  return validateUsername(username) ?? validatePassword(password) ?? (name === undefined ? null : validateName(name));
}
