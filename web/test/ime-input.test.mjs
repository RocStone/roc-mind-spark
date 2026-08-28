import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const { isImeEvent, shouldCommitEditOnBlur, shouldCommitEditOnPointerTarget, shouldCommitEditOnEscape, isEditSessionChrome, shouldFinishNodeEditOnEnter, isImeSwitchEvent, editSessionCreateAction, editSessionUndoAction, markImeCompositionEnd, isImeConfirmEnter, clearImeConfirmEnter } = loadFns([
  'isImeEvent',
  'shouldCommitEditOnBlur',
  'shouldCommitEditOnPointerTarget',
  'shouldCommitEditOnEscape',
  'isEditSessionChrome',
  'nowMs',
  'markImeCompositionEnd',
  'clearImeConfirmEnter',
  'isImeConfirmEnter',
  'shouldFinishNodeEditOnEnter',
  'isImeSwitchEvent',
  'editSessionCreateAction',
  'editSessionUndoAction',
], { IME_CONFIRM_MS: 80, _imeConfirmUntil: 0 });

describe('isImeEvent — do not steal 中文 IME keys', () => {
  test('plain latin typing is not IME', () => {
    assert.equal(isImeEvent({ key: 'n', keyCode: 78, isComposing: false }), false);
    assert.equal(isImeEvent({ key: 'Enter', keyCode: 13, isComposing: false }), false);
    assert.equal(isImeEvent({ key: ' ', keyCode: 32, isComposing: false }), false);
  });

  test('composition flag marks IME', () => {
    assert.equal(isImeEvent({ key: 'n', keyCode: 78, isComposing: true }), true);
  });

  test('keyCode 229 marks IME (Windows / Chrome)', () => {
    assert.equal(isImeEvent({ key: 'n', keyCode: 229, isComposing: false }), true);
  });

  test('key Process marks IME', () => {
    assert.equal(isImeEvent({ key: 'Process', keyCode: 229, isComposing: false }), true);
  });

  test('null / missing event is not IME', () => {
    assert.equal(isImeEvent(null), false);
    assert.equal(isImeEvent({}), false);
  });
});

describe('shouldCommitEditOnBlur — only a real click-away commits', () => {
  test('do not commit while composing', () => {
    assert.equal(shouldCommitEditOnBlur({ composing: true, activeInside: false, pointerOutside: true }), false);
  });

  test('do not commit when focus is still inside the editor chrome', () => {
    assert.equal(shouldCommitEditOnBlur({ composing: false, activeInside: true, pointerOutside: true }), false);
  });

  test('do not commit on a blur with no pointer-down outside', () => {
    assert.equal(shouldCommitEditOnBlur({ composing: false, activeInside: false, pointerOutside: false }), false);
  });

  test('commit a real click-away', () => {
    assert.equal(shouldCommitEditOnBlur({ composing: false, activeInside: false, pointerOutside: true }), true);
  });
});

describe('shouldCommitEditOnPointerTarget — click another node saves the open editor', () => {
  test('click inside the editing node does not commit', () => {
    const inner = {};
    const editing = { contains: (n) => n === inner };
    assert.equal(shouldCommitEditOnPointerTarget(inner, editing), false);
  });

  test('click on the format toolbar / picker does not commit', () => {
    const editing = { contains: () => false };
    const bar = { closest(sel) { return String(sel).includes('nodebar') ? this : null; } };
    assert.equal(shouldCommitEditOnPointerTarget(bar, editing), false);
  });

  test('click on another node or the canvas commits', () => {
    const editing = { contains: () => false };
    const other = { closest() { return null; } };
    assert.equal(shouldCommitEditOnPointerTarget(other, editing), true);
    assert.equal(shouldCommitEditOnPointerTarget(null, editing), false);
    assert.equal(shouldCommitEditOnPointerTarget(other, null), false);
  });
});

describe('shouldCommitEditOnEscape — Esc saves, IME composition does not', () => {
  test('bare Escape commits', () => {
    assert.equal(shouldCommitEditOnEscape({ key: 'Escape' }), true);
  });

  test('composing Escape stays with the IME', () => {
    assert.equal(shouldCommitEditOnEscape({ key: 'Escape', isComposing: true }), false);
    assert.equal(shouldCommitEditOnEscape({ key: 'Escape', keyCode: 229 }), false);
  });

  test('other keys do not commit', () => {
    assert.equal(shouldCommitEditOnEscape({ key: 'Enter' }), false);
    assert.equal(shouldCommitEditOnEscape(null), false);
  });
});

describe('isImeSwitchEvent — Caps Lock / Hyper+Space must stay with the OS IME', () => {
  test('Caps Lock is an IME switch', () => {
    assert.equal(isImeSwitchEvent({ key: 'CapsLock', code: 'CapsLock' }), true);
  });

  test('Ctrl+Space and Hyper+Space are IME switches', () => {
    assert.equal(isImeSwitchEvent({ key: ' ', code: 'Space', ctrlKey: true }), true);
    assert.equal(isImeSwitchEvent({ key: ' ', code: 'Space', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }), true);
  });

  test('any Hyper chord is treated as the IME-switch layer', () => {
    assert.equal(isImeSwitchEvent({ key: 'f', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }), true);
  });

  test('Lang1 / Lang2 OS keys are IME switches', () => {
    assert.equal(isImeSwitchEvent({ key: 'Lang1', code: 'Lang1' }), true);
    assert.equal(isImeSwitchEvent({ key: 'Lang2', code: 'Lang2' }), true);
  });

  test('plain Space / latin is not an IME switch', () => {
    assert.equal(isImeSwitchEvent({ key: ' ', code: 'Space' }), false);
    assert.equal(isImeSwitchEvent({ key: 'n', ctrlKey: false, metaKey: false }), false);
    assert.equal(isImeSwitchEvent(null), false);
  });
});

describe('shouldFinishNodeEditOnEnter — IME confirm stays with the IME', () => {
  test('bare Enter finishes the edit when the IME is idle', () => {
    clearImeConfirmEnter();
    assert.equal(shouldFinishNodeEditOnEnter({ key: 'Enter', ctrlKey: false, metaKey: false }), true);
  });

  test('Shift+Enter does not finish the edit', () => {
    assert.equal(shouldFinishNodeEditOnEnter({ key: 'Enter', shiftKey: true, ctrlKey: false, metaKey: false }), false);
  });

  test('composing Enter does not finish the edit', () => {
    assert.equal(shouldFinishNodeEditOnEnter({ key: 'Enter', isComposing: true }), false);
    assert.equal(shouldFinishNodeEditOnEnter({ key: 'Enter', keyCode: 229 }), false);
  });

  test('⌘+Enter still finishes the edit', () => {
    assert.equal(shouldFinishNodeEditOnEnter({ key: 'Enter', ctrlKey: false, metaKey: true }), true);
  });

  test('other keys do not finish', () => {
    assert.equal(shouldFinishNodeEditOnEnter({ key: 'Escape', metaKey: true }), false);
    assert.equal(shouldFinishNodeEditOnEnter(null), false);
  });
});

describe('isImeConfirmEnter — Enter right after compositionend is the IME confirm', () => {
  test('Enter immediately after compositionend is swallowed', () => {
    markImeCompositionEnd();
    assert.equal(isImeConfirmEnter({ key: 'Enter' }), true);
    assert.equal(editSessionCreateAction({ key: 'Enter' }), null);
  });

  test('other keys after compositionend are not swallowed', () => {
    markImeCompositionEnd();
    assert.equal(isImeConfirmEnter({ key: 'Tab' }), false);
  });
});

describe('editSessionCreateAction — Tab child / Enter sibling while editing', () => {
  test('bare Tab creates a child', () => {
    assert.equal(editSessionCreateAction({ key: 'Tab' }), 'child');
    assert.equal(editSessionCreateAction({ key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }), 'child');
  });

  test('Shift/Ctrl/⌘/Alt+Tab do not create a child', () => {
    assert.equal(editSessionCreateAction({ key: 'Tab', shiftKey: true }), null);
    assert.equal(editSessionCreateAction({ key: 'Tab', ctrlKey: true }), null);
    assert.equal(editSessionCreateAction({ key: 'Tab', metaKey: true }), null);
    assert.equal(editSessionCreateAction({ key: 'Tab', altKey: true }), null);
  });

  test('bare Enter creates a sibling when the IME is idle', () => {
    clearImeConfirmEnter();
    assert.equal(editSessionCreateAction({ key: 'Enter' }), 'sibling');
  });

  test('⌘+Enter and Ctrl+Enter still create a sibling', () => {
    assert.equal(editSessionCreateAction({ key: 'Enter', metaKey: true }), 'sibling');
    assert.equal(editSessionCreateAction({ key: 'Enter', ctrlKey: true }), 'sibling');
  });

  test('Shift+Enter stays a newline', () => {
    assert.equal(editSessionCreateAction({ key: 'Enter', shiftKey: true }), null);
    assert.equal(editSessionCreateAction({ key: 'Enter', shiftKey: true, metaKey: true }), null);
  });

  test('composing Enter does not create a sibling', () => {
    assert.equal(editSessionCreateAction({ key: 'Enter', isComposing: true }), null);
    assert.equal(editSessionCreateAction({ key: 'Enter', keyCode: 229 }), null);
  });

  test('other keys and a missing event do nothing', () => {
    assert.equal(editSessionCreateAction({ key: 'Escape' }), null);
    assert.equal(editSessionCreateAction({ key: 'b', metaKey: true }), null);
    assert.equal(editSessionCreateAction(null), null);
  });
});

describe('isEditSessionChrome', () => {
  test('body / missing is not editor chrome', () => {
    assert.equal(isEditSessionChrome(null), false);
    assert.equal(isEditSessionChrome({}), false);
  });
});

describe('editSessionUndoAction', () => {
  test('Cmd+Z undoes, Cmd+Shift+Z / Cmd+Y redo', () => {
    assert.equal(editSessionUndoAction({ key: 'z', metaKey: true }), 'undo');
    assert.equal(editSessionUndoAction({ key: 'z', metaKey: true, shiftKey: true }), 'redo');
    assert.equal(editSessionUndoAction({ key: 'y', ctrlKey: true }), 'redo');
  });

  test('plain z is not undo', () => {
    assert.equal(editSessionUndoAction({ key: 'z' }), null);
    assert.equal(editSessionUndoAction(null), null);
  });
});


