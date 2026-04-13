import type { Session } from '@/types';

export const DRUG_CHAT_SESSION_NAME = 'Drugs Chat';
export const DRUG_CHAT_SESSION_DESCRIPTION = 'Drug mode only';

export const isDrugOnlySession = (session?: Session | null): boolean =>
  Boolean(
    session?.isDrugSession ||
    (session?.name === DRUG_CHAT_SESSION_NAME && session?.description === DRUG_CHAT_SESSION_DESCRIPTION)
  );
