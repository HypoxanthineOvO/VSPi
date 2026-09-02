import { Container, Markdown, Spacer, type MarkdownTheme } from '@moonshot-ai/pi-tui';

interface AssistantMessage {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

type MarkdownTransformer = (
  source: string,
  context: { messageType: 'assistant'; isStreaming: boolean; availableWidth: number },
) => string;

export class AssistantMessageComponent extends Container {
  private readonly contentContainer = new Container();
  private lastMessage: AssistantMessage | undefined;
  private streaming = false;

  constructor(
    message: AssistantMessage | undefined,
    _hideThinkingBlock: boolean,
    private readonly markdownTheme: MarkdownTheme,
    _hiddenThinkingLabel: string,
    private readonly outputPad: number,
    private readonly transformers: readonly MarkdownTransformer[],
  ) {
    super();
    this.addChild(this.contentContainer);
    if (message !== undefined) this.updateContent(message);
  }

  updateContent(message: AssistantMessage, isStreaming = this.streaming): void {
    this.lastMessage = message;
    this.streaming = isStreaming;
    this.contentContainer.clear();
    const text = message.content
      .filter((part): part is { readonly type: 'text'; readonly text: string } =>
        part.type === 'text' && typeof part.text === 'string',
      )
      .map((part) => part.text)
      .join('\n\n')
      .trim();
    if (text.length === 0) return;
    this.contentContainer.addChild(new Spacer(1));
    this.contentContainer.addChild(
      new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
        transform: (source, availableWidth) =>
          this.transformers.reduce(
            (current, transformer) =>
              transformer(current, { messageType: 'assistant', isStreaming, availableWidth }),
            source,
          ),
      }),
    );
  }

  override invalidate(): void {
    super.invalidate();
    if (this.lastMessage !== undefined) this.updateContent(this.lastMessage);
  }
}
