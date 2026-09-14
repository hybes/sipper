// Window-local interface state shared by the views: the selected page, the open dialog and the
// dialler's text. App (app.js) provides it.

import { createContext, useContext } from './lib.js';

export const UIContext = createContext(null);

/** { selection, navigate(target), openDialog(dialog), closeDialog(), dialString, setDialString, focusDialerToken, focusDialer() } */
export const useUI = () => useContext(UIContext);
