import { writable } from "svelte/store";
import { loadHubNavigatorSide, saveHubNavigatorSide } from "$lib/hub/hubNavigator";

/// Where the navigator stands. Every write reaches storage.
export const hubNavigatorSide = writable(loadHubNavigatorSide());
hubNavigatorSide.subscribe((side) => saveHubNavigatorSide(side));
