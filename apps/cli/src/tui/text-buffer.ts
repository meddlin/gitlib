/** A cursor-aware text buffer backing the single- and multi-line inputs. */
export class TextBuffer {
  value: string;
  cursor: number;

  constructor(value = "") {
    this.value = value;
    this.cursor = value.length;
  }

  insert(text: string): void {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
    this.cursor -= 1;
  }

  deleteForward(): void {
    this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
  }

  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right(): void {
    this.cursor = Math.min(this.value.length, this.cursor + 1);
  }

  /** Row/column of the cursor, where rows are separated by `\n`. */
  position(): { row: number; column: number } {
    const before = this.value.slice(0, this.cursor).split("\n");
    return { row: before.length - 1, column: before[before.length - 1]!.length };
  }

  private moveToRow(target: number): void {
    const lines = this.value.split("\n");
    const { column } = this.position();
    const row = Math.min(Math.max(target, 0), lines.length - 1);
    let offset = 0;
    for (let index = 0; index < row; index++) offset += lines[index]!.length + 1;
    this.cursor = offset + Math.min(column, lines[row]!.length);
  }

  up(): void {
    this.moveToRow(this.position().row - 1);
  }

  down(): void {
    this.moveToRow(this.position().row + 1);
  }

  /** Moves the cursor to a row/column, clamping to the text that exists. */
  setPosition(row: number, column: number): void {
    const lines = this.value.split("\n");
    const targetRow = Math.min(Math.max(row, 0), lines.length - 1);
    let offset = 0;
    for (let index = 0; index < targetRow; index++) offset += lines[index]!.length + 1;
    this.cursor = offset + Math.min(Math.max(column, 0), lines[targetRow]!.length);
  }

  home(): void {
    this.cursor -= this.position().column;
  }

  end(): void {
    const lineEnd = this.value.indexOf("\n", this.cursor);
    this.cursor = lineEnd === -1 ? this.value.length : lineEnd;
  }
}
