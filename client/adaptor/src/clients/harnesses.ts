import type { Harness } from '@starrychat/adaptor-contracts';
import { createPiHarness } from '@starrychat/pi-adaptor';
import type { Config } from '../config/config.ts';

// The first registered harness is the default for an Agent without a session.
export function createHarnesses(config: Config): Harness[] {
  return [createPiHarness({ cliPath: config.pi_cli_path })];
}
