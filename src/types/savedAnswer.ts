export interface SavedAnswer {
  id: string;
  sourceMessageId: string;
  userId: string;
  sessionId: string;
  sessionName: string;
  content: string;
  savedAt: Date;
}

export interface SavedAnswerCreate {
  sourceMessageId: string;
  userId: string;
  sessionId: string;
  sessionName: string;
  content: string;
  savedAt?: Date;
}
