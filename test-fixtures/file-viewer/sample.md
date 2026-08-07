# Markdown Rendering Test

This file exercises every markdown feature `FileViewerPane.svelte` styles.
If you are reading this **as rendered HTML** (bold text, real headings, a
styled table below), the `marked` + `DOMPurify` path is working. If you
are seeing the raw `#` and `**` characters instead, it is falling through
to the plain-text path — that's a bug.

## Inline formatting

**Bold**, *italic*, `inline code`, and a [link to example.com](https://example.com)
which should render blue and be clickable.

## A fenced code block

```typescript
export function greet(name: string): string {
  // This block should have a distinct background from the page.
  return `hello, ${name}`;
}
```

## A table

| Feature | Expected |
| --- | --- |
| Borders | Visible, 1px, grey |
| Padding | Comfortable, not cramped |
| Alignment | Left by default |

## A list

1. Ordered item one
2. Ordered item two
   - Nested unordered item
   - Another nested item

## Blockquote

> If this renders with the browser's default blockquote indent, that is
> expected — the viewer only styles pre/code/a/table/th/td explicitly.

## Live-reload check

Append a line to this file from another terminal and watch it appear here
within about a second, without touching the pane:

    echo '- appended at '"$(date +%T)" >> test-fixtures/file-viewer/sample.md
- appended at 14:59:22
- appended at 15:00:00
