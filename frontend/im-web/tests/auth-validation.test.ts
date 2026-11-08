import { describe, expect, it } from 'vitest';
import { validateCredentials } from '../src/features/auth/validation';

describe('authentication input rules', () => {
  it('validates the ASCII username and UTF-8 byte length rather than character count', () => {
    expect(validateCredentials('ab', '12345678')).toMatch(/账号/);
    expect(validateCredentials('-abc', '12345678')).toMatch(/账号/);
    expect(validateCredentials('中文abc', '12345678')).toMatch(/账号/);
    expect(validateCredentials('a'.repeat(65), '12345678')).toMatch(/账号/);
    expect(validateCredentials('abc', '1234567')).toMatch(/密码/);
    expect(validateCredentials('abc', '中'.repeat(24))).toBeNull();
    expect(validateCredentials('abc', '中'.repeat(25))).toMatch(/密码/);
    expect(validateCredentials('a._-0', '12345678')).toBeNull();
  });
  it('counts Unicode code points in display names', () => {
    expect(validateCredentials('abc', '12345678', '😀'.repeat(100))).toBeNull();
    expect(validateCredentials('abc', '12345678', '😀'.repeat(101))).toMatch(/显示名称/);
    expect(validateCredentials('abc', '12345678', '  ')).toMatch(/显示名称/);
  });
});
