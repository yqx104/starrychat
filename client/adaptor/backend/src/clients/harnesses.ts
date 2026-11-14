import { PiSession, type SessionFactory } from '@starrychat/pi-adaptor';

export const createSession: SessionFactory = config => new PiSession(config);
