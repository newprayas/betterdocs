export const getSessionRoute = (sessionId: string): string => {
  return `/session/index?sid=${encodeURIComponent(sessionId)}`;
};
