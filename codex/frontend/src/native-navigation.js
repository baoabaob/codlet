// Reviewed React Router ownership: older builds expose their memory history;
// build 11645 uses a data router whose single wildcard route owns the same JSX
// route tree. Observe that router; never construct a replacement native router.
const bridges = new WeakMap();
const subscribable = new WeakSet();

export function subscribeNativeRoute(navigator, listener) {
  // React Router data routers support several subscribers. Legacy memory
  // histories own a single listener, so their routes are observed at DOM commit.
  return subscribable.has(navigator) ? navigator.listen(listener) : null;
}

export function reviewedNavigator(navigators, contexts) {
  if (navigators.size !== 1) return null;
  const navigator = [...navigators][0];
  if (typeof navigator?.location?.pathname === 'string' &&
      ['push', 'replace', 'listen'].every(name => typeof navigator[name] === 'function')) return navigator;
  const matches = [...contexts].filter(value => value.navigator === navigator && value.router);
  const routers = new Set(matches.map(value => value.router));
  if (routers.size !== 1) return null;
  const router = [...routers][0];
  if (typeof router.state?.location?.pathname !== 'string' ||
      typeof router.navigate !== 'function' || typeof router.subscribe !== 'function' ||
      !Array.isArray(router.routes) || router.routes.length !== 1 || router.routes[0].path !== '*') return null;
  const existing = bridges.get(router);
  if (existing) return existing.navigator === navigator && existing.navigate === router.navigate &&
    existing.subscribe === router.subscribe ? existing.bridge : null;
  const navigate = router.navigate, subscribe = router.subscribe;
  const bridge = {
    get location() { return router.state.location; },
    push(to, state) { return navigate.call(router, to, { state }); },
    replace(to, state) { return navigate.call(router, to, { replace: true, state }); },
    go(delta) { return navigate.call(router, delta); },
    listen(listener) {
      let location = router.state.location;
      return subscribe.call(router, state => {
        if (state.location === location) return;
        location = state.location;
        listener({ location, action: state.historyAction });
      });
    },
  };
  bridges.set(router, { navigator, navigate, subscribe, bridge });
  subscribable.add(bridge);
  return bridge;
}
