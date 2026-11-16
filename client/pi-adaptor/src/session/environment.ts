export function isolatedEnvironment(directory: string): Record<string, string> {
  const env: Record<string, string> = {};
  // Keep process essentials; never copy the host's model, auth, cloud or Node preload settings.
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, PI_CODING_AGENT_DIR: directory, PI_ADAPTOR_CONFIG_ONLY: '1' };
}
