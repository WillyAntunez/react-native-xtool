// rn-xtool copies this file into ios-xtool/Sources/RNXtoolDevSupport on every build; edit it in rn-xtool's
// templates/dev-support. When to connect, reload, give up or alert. No I/O: tests/devSupport.test.ts runs it on Linux.
#include "RNXtoolDevSupport.h"

void rnx_init(rnx_state *s) {
  *s = (rnx_state){.foreground = true, .first_failure_at = -1, .active_since = -1, .denied_since = -1};
}

static bool rnx_expired(const rnx_state *s, double now) {
  return s->first_failure_at >= 0 && now - s->first_failure_at > RNX_GIVE_UP_SECONDS;
}

static rnx_action rnx_give_up(rnx_state *s) {
  s->pending = s->connecting = false;
  return RNX_ACTION_STOP;
}

rnx_action rnx_step(rnx_state *s, rnx_event event, double now) {
  switch (event) {
    case RNX_EVENT_BUNDLE_LOADED:
      s->loaded = true;
      if (!s->pending && !s->connecting) return RNX_ACTION_NONE;
      return rnx_give_up(s);
    case RNX_EVENT_BUNDLE_FAILED:
      if (s->loaded || s->pending) return RNX_ACTION_NONE;
      if (s->first_failure_at < 0) s->first_failure_at = now;
      if (rnx_expired(s, now)) return RNX_ACTION_NONE;
      s->pending = true;
      // In the background iOS denies local network access without asking (TN3179): count it as out of reach.
      s->saw_unreachable = !s->foreground;
      if (!s->foreground) return RNX_ACTION_NONE;
      s->connecting = true;
      return RNX_ACTION_CONNECT;
    case RNX_EVENT_METRO_READY:
      s->denied_since = -1;
      if (!s->connecting) return RNX_ACTION_NONE;
      s->pending = s->connecting = false;
      // Reachable at once: the load failed for another reason (a bundling error), and a reload would fail again.
      return s->saw_unreachable && s->foreground ? RNX_ACTION_RELOAD : RNX_ACTION_STOP;
    case RNX_EVENT_METRO_UNREACHABLE:
    case RNX_EVENT_LOCAL_NETWORK_DENIED:
      if (event == RNX_EVENT_LOCAL_NETWORK_DENIED) {
        if (s->denied_since < 0) s->denied_since = now;
      } else {
        s->denied_since = -1;
      }
      if (!s->connecting) return RNX_ACTION_NONE;
      s->saw_unreachable = true;
      if (rnx_expired(s, now)) return rnx_give_up(s);
      if (s->retry_scheduled) return RNX_ACTION_NONE;
      s->retry_scheduled = true;
      return RNX_ACTION_RETRY_LATER;
    case RNX_EVENT_RETRY_DUE:
      s->retry_scheduled = false;
      if (!s->pending || !s->connecting || !s->foreground) return RNX_ACTION_NONE;
      if (rnx_expired(s, now)) return rnx_give_up(s);
      return RNX_ACTION_CONNECT;
    case RNX_EVENT_RESIGN_ACTIVE:
      s->active = false;
      return RNX_ACTION_NONE;
    case RNX_EVENT_BACKGROUND:
      s->foreground = s->active = false;
      if (!s->connecting) return RNX_ACTION_NONE;
      s->connecting = false;
      return RNX_ACTION_DISCONNECT;
    case RNX_EVENT_FOREGROUND:
      s->foreground = s->active = true;
      s->active_since = now;
      // A denial seen before the app left may be stale (access granted in Settings): wait for a new report.
      s->denied_since = -1;
      if (!s->pending || s->connecting) return RNX_ACTION_NONE;
      if (rnx_expired(s, now)) return rnx_give_up(s);
      s->connecting = true;
      return RNX_ACTION_CONNECT;
  }
  return RNX_ACTION_NONE;
}

bool rnx_should_alert(const rnx_state *s, double now) {
  if (s->alerted || s->loaded || !s->pending || !s->active || s->denied_since < 0 || rnx_expired(s, now)) return false;
  // The system's Local Network prompt makes the app inactive: count only denials seen while nothing covers the app.
  double since = s->denied_since > s->active_since ? s->denied_since : s->active_since;
  return now - since >= RNX_ALERT_AFTER_SECONDS;
}

// Only once UIKit took the alert: a refused presentation (no window, another presentation running) is retried.
void rnx_alert_shown(rnx_state *s) { s->alerted = true; }
