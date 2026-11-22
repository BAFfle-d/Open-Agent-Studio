/** Items the owner can drag into the world (or onto the drop box). */
import { OBJECT_DEFS, RESOURCE_KINDS, type ObjectKind } from '@blurb/shared';
import type { PlaceKind } from '../../../ipc-types';
import { ObjectThumb } from './Thumbs';
import { DRAG_MIME } from './WorldView';

const GROUPS: Array<{ label: string; items: Array<PlaceKind | 'treat'> }> = [
  { label: 'Snacks', items: ['treat'] },
  { label: 'Resources', items: RESOURCE_KINDS.map((r) => `resource:${r}` as PlaceKind) },
  { label: 'Toys', items: ['ball', 'yarn', 'plushie'] },
  { label: 'Decor', items: ['flowers', 'bush', 'plant_pot', 'lamp', 'rug', 'tree'] },
  { label: 'Furniture', items: ['bed', 'bookshelf', 'workbench', 'food_bowl'] },
];

function label(k: PlaceKind | 'treat') {
  if (k === 'treat') return 'Cookie (fills the bowl)';
  if (k.startsWith('resource:')) return k.slice(9);
  return OBJECT_DEFS[k as ObjectKind].label;
}

export function Palette() {
  return (
    <div className="palette" aria-label="Item palette — drag into the world, or onto the drop box">
      {GROUPS.map((g) => (
        <div className="palette-group" key={g.label}>
          <span className="palette-label">{g.label}</span>
          <div className="palette-items">
            {g.items.map((k) => (
              <div
                key={k}
                className="palette-item"
                draggable
                title={`${label(k)} — drag into the world, or onto the drop box`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, k);
                  e.dataTransfer.effectAllowed = 'copy';
                  (window as unknown as { __blurbDrag?: string }).__blurbDrag = k === 'treat' ? undefined : k;
                }}
                onDragEnd={() => ((window as unknown as { __blurbDrag?: string }).__blurbDrag = undefined)}
              >
                {k === 'treat' ? <span className="treat-emoji">🍪</span> : <ObjectThumb kind={k} size={34} />}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
