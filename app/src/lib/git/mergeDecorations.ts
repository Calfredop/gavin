// Line-region decorations for the merge editor panes: a background class
// per line, a numbered badge on the region's first line and — in the Result
// pane — inline choice buttons. Regions are pushed through a StateEffect so
// the same editor instance is re-decorated on every document change.

import type { EditorHandle } from "$lib/files/codeMirror";
import type { Decoration as CmDecoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";

export interface RegionAction {
  label: string;
  title: string;
  onPick: () => void;
}

export interface Region {
  /// 0-based line range [from, to).
  from: number;
  to: number;
  /// CSS class applied to every line of the region.
  cls: string;
  /// 1-based conflict number shown as a badge on the first line.
  index: number;
  active?: boolean;
  actions?: RegionAction[];
}

export interface RegionDecorations {
  extension: unknown;
  setRegions(handle: EditorHandle, regions: Region[]): void;
}

export async function createRegionDecorations(): Promise<RegionDecorations> {
  const [{ StateEffect, StateField }, { Decoration, EditorView, WidgetType }] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
  ]);

  class BadgeWidget extends WidgetType {
    constructor(
      private readonly region: Region
    ) {
      super();
    }
    eq(other: BadgeWidget): boolean {
      return other.region.index === this.region.index && other.region.active === this.region.active && (other.region.actions?.length ?? 0) === (this.region.actions?.length ?? 0);
    }
    toDOM(): HTMLElement {
      const wrap = document.createElement("span");
      wrap.className = "cm-conflict-badge" + (this.region.active ? " active" : "");
      const num = document.createElement("span");
      num.className = "cm-conflict-num";
      num.textContent = String(this.region.index);
      wrap.appendChild(num);
      for (const a of this.region.actions ?? []) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cm-conflict-act";
        b.textContent = a.label;
        b.title = a.title;
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          a.onPick();
        });
        wrap.appendChild(b);
      }
      return wrap;
    }
    ignoreEvent(): boolean {
      return true;
    }
  }

  const setRegionsEffect = StateEffect.define<Region[]>();

  const field = StateField.define({
    create() {
      return Decoration.none;
    },
    update(deco, tr) {
      let next = deco.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setRegionsEffect)) {
          const ranges: Range<CmDecoration>[] = [];
          const doc = tr.state.doc;
          for (const r of e.value) {
            const first = Math.min(r.from, doc.lines - 1);
            const last = Math.min(r.to, doc.lines);
            for (let l = first; l < last; l++) {
              const line = doc.line(l + 1);
              ranges.push(Decoration.line({ class: r.cls + (r.active ? " active" : "") }).range(line.from));
            }
            if (first < doc.lines) {
              const line = doc.line(first + 1);
              ranges.push(Decoration.widget({ widget: new BadgeWidget(r), side: -1 }).range(line.from));
            }
          }
          next = Decoration.set(ranges, true);
        }
      }
      return next;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return {
    extension: field,
    setRegions(handle, regions) {
      handle.dispatchEffects([setRegionsEffect.of(regions)]);
    },
  };
}
