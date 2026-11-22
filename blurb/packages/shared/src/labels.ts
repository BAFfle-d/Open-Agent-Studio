import type { Emotion } from './types.js';

/** Human sentences for activities (shown on the fan page and desktop status). */
export const ACTIVITY_LABELS: Record<string, string> = {
  idle: 'chilling',
  walking: 'toddling about',
  sleeping: 'fast asleep',
  eating: 'munching a snack',
  reading: 'reading a book',
  coding: 'tinkering at the computer',
  playing: 'playing',
  building: 'building something at the workbench',
  foraging: 'foraging in the yard',
  checking_dropbox: 'checking the drop box',
  writing_note: 'leaving a note in the comm box',
  chatting: 'chatting',
  being_pet: 'getting pets',
  dragged: 'being carried around',
  falling: 'wheee — falling!',
  desktop_wander: 'strolling along the taskbar',
  desktop_window_sit: 'perched on a window',
  desktop_chase_cursor: 'chasing the cursor',
  desktop_nap: 'napping in a corner',
  wandering: 'strolling along the taskbar',
  perched: 'perched on top of a window',
  playing_chase: 'chasing the cursor',
  napping: 'napping in a corner',
};

export const EMOTION_EMOJI: Record<Emotion, string> = {
  neutral: '🙂',
  happy: '😊',
  excited: '🤩',
  thinking: '🤔',
  sleepy: '😴',
  confused: '😵‍💫',
  sad: '🥺',
  love: '🥰',
};
