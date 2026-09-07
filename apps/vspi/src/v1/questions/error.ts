export class UserQuestionCancelledError extends Error {
  constructor(message = 'Question cancelled by user') {
    super(message);
    this.name = 'UserQuestionCancelledError';
  }
}
