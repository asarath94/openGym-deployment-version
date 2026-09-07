// api/server.js

/* openGym API — passkey (WebAuthn) auth + per-user state storage
   MongoDB-backed persistence, signed session cookies, Web Push. */

import http from "node:http";
import crypto from "node:crypto";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

import webpush from "web-push";

import {
  initStorage,
  closeStorage,
  getUsers,
  countUsers,
  getUserById,
  createUser,
  updateUser,
  updateUserFields,
  getCredentialById,
  credentialExists,
  createCredential,
  updateCredentialCounter,
  getSubscriptionsByUserId,
  upsertSubscription,
  removeSubscription,
  hasSubscription,
  getInvites,
  getInviteByCode,
  createInvite,
  updateInvite,
  deleteInvite,
  getUserState,
  saveUserState,
} from "./storage.js";

/* ---------- configuration ---------- */

const PORT = +(process.env.PORT || 3000);

const RP_ID = process.env.RP_ID || "localhost";
const ORIGIN = process.env.ORIGIN || "http://localhost:8080";
const RP_NAME = process.env.RP_NAME || "openGym";

const ADMIN_UIDS = (process.env.ADMIN_UIDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || "");

const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);

const MAX_BODY = 5 * 1024 * 1024;

/*
 * HTTPS is required for secure cookies.
 * localhost is the special development exception.
 */
const SECURE = /^https:/i.test(ORIGIN) ? " Secure;" : "";

/* ---------- secrets ---------- */

/*
 * IMPORTANT:
 * In the old version this was generated into /data/secret.
 *
 * For Render/MongoDB deployment we keep the secret in an environment
 * variable so the application no longer depends on persistent local files.
 */
const SECRET = process.env.SESSION_SECRET;

if (!SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}

/* ---------- helpers ---------- */

function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);

  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(extraHeaders || {}),
  });

  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (d) => {
      size += d.length;

      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }

      chunks.push(d);
    });

    req.on("end", () => {
      try {
        resolve(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : {},
        );
      } catch {
        reject(new Error("bad json"));
      }
    });

    req.on("error", reject);
  });
}

const b64uToBuf = (s) => Buffer.from(s, "base64url");

/* ---------- users/admin ---------- */

function isAdmin(user) {
  return !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
}

/* ---------- push notifications / VAPID ---------- */

/*
 * VAPID keys are now supplied through environment variables.
 *
 * Required:
 *
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *
 * VAPID_SUBJECT is optional. When omitted, ORIGIN is used for HTTPS.
 */

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  throw new Error(
    "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables are required",
  );
}

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : "mailto:admin@localhost");

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function sendPush(userId, payload) {
  const subs = await getSubscriptionsByUserId(userId);

  if (!subs.length) return;

  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: sub.keys,
          },
          body,
          {
            urgency: "high",
          },
        );
      } catch (e) {
        console.error(
          "push send failed",
          userId,
          e.statusCode,
          e.body || e.message,
        );

        /*
         * Remove subscriptions that the push provider explicitly reports
         * as permanently gone.
         */
        if (e.statusCode === 404 || e.statusCode === 410) {
          try {
            await removeSubscription(userId, sub.endpoint);
          } catch (removeError) {
            console.error(
              "failed removing dead push subscription",
              removeError,
            );
          }
        }
      }
    }),
  );
}

/* ---------- rest-timer alerts ---------- */

/*
 * Rest timers remain deliberately in-memory.
 *
 * They are temporary runtime state, not user data that needs persistence.
 */
const restTimers = new Map(); // userId -> Timeout

function scheduleRestTimer(userId, sec) {
  const existing = restTimers.get(userId);

  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    restTimers.delete(userId);

    void sendPush(userId, {
      title: "Rest over 💪",
      body: "Time for your next set.",
      tag: "rest-timer",
    });
  }, sec * 1000);

  restTimers.set(userId, timer);
}

function cancelRestTimer(userId) {
  const timer = restTimers.get(userId);

  if (timer) {
    clearTimeout(timer);
    restTimers.delete(userId);
  }
}

/* ---------- workout reminders ---------- */

function effectiveRoutineId(S, iso) {
  const override = S.dayPlan?.[iso];

  if (override === "rest") {
    return null;
  }

  if (override && S.routines?.some((r) => r.id === override)) {
    return override;
  }

  const wd = new Date(iso + "T12:00:00").getDay();

  return S.week?.[wd] || null;
}

function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date());

    const get = (type) => parts.find((p) => p.type === type)?.value;

    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      hhmm: `${get("hour")}:${get("minute")}`,
    };
  } catch {
    /*
     * Unknown/invalid timezone.
     * Skip rather than guessing.
     */
    return null;
  }
}

/*
 * Workout reminder loop.
 *
 * This remains a background timer, exactly as in the original app.
 *
 * IMPORTANT for our Render deployment:
 * on a sleeping Render free service this loop cannot execute while
 * the service is asleep. We will address that deployment limitation
 * separately later.
 */
setInterval(async () => {
  try {
    const users = await getUsers();

    for (const user of users) {
      if (!(await hasSubscription(user.id))) {
        continue;
      }

      const S = await getUserState(user.id);

      if (!S?.reminder?.on) {
        continue;
      }

      const now = userNow(S.reminder.tz || "UTC");

      if (!now) {
        continue;
      }

      if (S.reminder.time !== now.hhmm) {
        continue;
      }

      if (user.lastReminder === now.date) {
        continue;
      }

      if ((S.workouts || []).some((workout) => workout.d === now.date)) {
        continue;
      }

      const rid = effectiveRoutineId(S, now.date);

      /*
       * Rest day — nothing to remind the user about.
       */
      if (!rid) {
        continue;
      }

      const routine = (S.routines || []).find((r) => r.id === rid);

      console.log("reminder firing", user.id, rid);

      /*
       * Update the reminder marker in MongoDB so the reminder
       * isn't sent repeatedly during the same minute/day.
       */
      await updateUserFields(user.id, {
        lastReminder: now.date,
      });

      await sendPush(user.id, {
        title: routine
          ? `${routine.emoji || "🏋️"} ${routine.name} today`
          : "Workout planned today",
        body: "It's on your plan — let's go 💪",
        tag: "day-reminder",
      });
    }
  } catch (e) {
    console.error("reminder loop failed", e);
  }
}, 10000).unref();

/* ---------- sessions ---------- */

function sign(payload) {
  const mac = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("base64url");

  return payload + "." + mac;
}

function verifySig(token) {
  const i = token.lastIndexOf(".");

  if (i < 0) {
    return null;
  }

  const payload = token.slice(0, i);
  const mac = token.slice(i + 1);

  const expect = crypto
    .createHmac("sha256", SECRET)
    .update(payload)
    .digest("base64url");

  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) {
      return null;
    }
  } catch {
    return null;
  }

  return payload;
}

const sessionVersion = (user) => user.sv || 0;

function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;

  return sign(user.id + ":" + exp + ":" + sessionVersion(user));
}

/*
 * Unlike the original server, this function is now async because
 * the user is loaded from MongoDB.
 */
async function readSession(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => {
      const i = c.indexOf("=");

      return i < 0 ? ["", ""] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    }),
  );

  const tok = cookies.gymsid;

  if (!tok) {
    return null;
  }

  const payload = verifySig(tok);

  if (!payload) {
    return null;
  }

  const [uid, exp, ver] = payload.split(":");

  if (!uid || +exp < Date.now()) {
    return null;
  }

  const user = await getUserById(uid);

  if (!user) {
    return null;
  }

  if (user.disabled) {
    return null;
  }

  /*
   * Missing third field means an old cookie.
   * Preserve compatibility with the previous version.
   */
  const claimed = ver === undefined ? 0 : Number(ver);

  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) {
    return null;
  }

  return user;
}

/*
 * Admin guard is now async because authentication requires MongoDB.
 */
async function requireAdmin(req, res) {
  const user = await readSession(req);

  if (!user) {
    json(res, 401, {
      error: "not signed in",
    });

    return null;
  }

  if (!isAdmin(user)) {
    json(res, 403, {
      error: "forbidden",
    });

    return null;
  }

  return user;
}

function sessionCookie(user) {
  return [
    `gymsid=${makeSession(user)}`,
    "Path=/",
    `Max-Age=${SESSION_DAYS * 86400}`,
    "HttpOnly",
    SECURE,
    "SameSite=Lax",
  ].join("; ");
}

const clearCookie = [
  "gymsid=",
  "Path=/",
  "Max-Age=0",
  "HttpOnly",
  SECURE,
  "SameSite=Lax",
].join("; ");

/* ---------- challenge store ---------- */

/*
 * WebAuthn challenges remain in memory.
 * They are short-lived and do not belong in persistent storage.
 */
const challenges = new Map();
// cid -> { challenge, name?, uid?, code?, exp }

function putChallenge(data) {
  const cid = crypto.randomBytes(16).toString("base64url");

  challenges.set(cid, {
    ...data,
    exp: Date.now() + 5 * 60000,
  });

  return cid;
}

function takeChallenge(cid) {
  const c = challenges.get(cid);

  challenges.delete(cid);

  if (!c || c.exp < Date.now()) {
    return null;
  }

  return c;
}

setInterval(() => {
  for (const [key, value] of challenges) {
    if (value.exp < Date.now()) {
      challenges.delete(key);
    }
  }
}, 60000).unref();

/* ---------- live presence ---------- */

const presence = new Map();

const PRESENCE_TTL = 70000;

function livePresence(uid) {
  const p = presence.get(uid);

  if (!p) {
    return null;
  }

  if (Date.now() - p.updatedAt > PRESENCE_TTL) {
    presence.delete(uid);
    return null;
  }

  return p;
}

setInterval(() => {
  for (const [key, value] of presence) {
    if (Date.now() - value.updatedAt > PRESENCE_TTL) {
      presence.delete(key);
    }
  }
}, 30000).unref();

/* ---------- routes ---------- */

const routes = {
  "GET /api/health": async (req, res) => {
    const users = await countUsers();

    json(res, 200, {
      ok: true,
      users,
    });
  },

  "GET /api/config": async (req, res) => {
    json(res, 200, {
      invite_only: INVITE_ONLY,
    });
  },

  "GET /api/me": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    json(res, 200, {
      user: {
        id: user.id,
        name: user.name,
        admin: isAdmin(user),
      },
    });
  },

  /* ---------- registration ---------- */

  "POST /api/register/options": async (req, res) => {
    const body = await readBody(req);

    const name = String(body.name || "")
      .trim()
      .slice(0, 40);

    if (!name) {
      return json(res, 400, {
        error: "name required",
      });
    }

    const code = String(body.code || "")
      .trim()
      .toUpperCase();

    if (INVITE_ONLY) {
      const invite = await getInviteByCode(code);

      if (!invite || invite.usedBy || invite.revoked) {
        return json(res, 403, {
          error: "a valid invite code is required",
        });
      }
    }

    const uid = crypto.randomBytes(12).toString("base64url");

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,

      userID: Buffer.from(uid),
      userName: name,
      userDisplayName: name,

      attestationType: "none",

      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },

      excludeCredentials: [],
    });

    const cid = putChallenge({
      challenge: options.challenge,
      name,
      uid,
      code,
    });

    json(res, 200, {
      cid,
      options,
    });
  },

  "POST /api/register/verify": async (req, res) => {
    const body = await readBody(req);

    const c = takeChallenge(body.cid);

    if (!c || !c.uid) {
      return json(res, 400, {
        error: "challenge expired — try again",
      });
    }

    let verification;

    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,

        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,

        requireUserVerification: false,
      });
    } catch (e) {
      return json(res, 400, {
        error: "verification failed: " + e.message,
      });
    }

    if (!verification.verified) {
      return json(res, 400, {
        error: "not verified",
      });
    }

    const { credential } = verification.registrationInfo;

    if (await credentialExists(credential.id)) {
      return json(res, 409, {
        error: "credential already registered",
      });
    }

    /*
     * Re-check the invite immediately before burning it.
     */
    let invite = null;

    if (INVITE_ONLY) {
      invite = await getInviteByCode(c.code);

      if (!invite || invite.usedBy || invite.revoked) {
        return json(res, 403, {
          error: "invite code is no longer valid — ask for a new one",
        });
      }
    }

    const user = {
      id: c.uid,
      name: c.name,
      created: new Date().toISOString(),
    };

    if (invite) {
      user.invitedBy = invite.code;

      await updateInvite({
        ...invite,
        usedBy: user.id,
        usedAt: user.created,
      });
    }

    await createUser(user);

    await createCredential({
      id: credential.id,
      userId: user.id,

      publicKey: Buffer.from(credential.publicKey).toString("base64url"),

      counter: credential.counter || 0,

      transports: body.credential?.response?.transports || [],
    });

    json(
      res,
      200,
      {
        user: {
          id: user.id,
          name: user.name,
          admin: isAdmin(user),
        },
      },
      {
        "Set-Cookie": sessionCookie(user),
      },
    );
  },

  /* ---------- login ---------- */

  "POST /api/login/options": async (req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "preferred",
      allowCredentials: [],
    });

    const cid = putChallenge({
      challenge: options.challenge,
    });

    json(res, 200, {
      cid,
      options,
    });
  },

  "POST /api/login/verify": async (req, res) => {
    const body = await readBody(req);

    const c = takeChallenge(body.cid);

    if (!c) {
      return json(res, 400, {
        error: "challenge expired — try again",
      });
    }

    const cred = await getCredentialById(body.credential?.id);

    if (!cred) {
      return json(res, 404, {
        error: "unknown passkey — create a profile first",
      });
    }

    let verification;

    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,

        expectedChallenge: c.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,

        requireUserVerification: false,

        credential: {
          id: cred.id,

          publicKey: b64uToBuf(cred.publicKey),

          counter: cred.counter,

          transports: cred.transports,
        },
      });
    } catch (e) {
      return json(res, 400, {
        error: "verification failed: " + e.message,
      });
    }

    if (!verification.verified) {
      return json(res, 400, {
        error: "not verified",
      });
    }

    await updateCredentialCounter(
      cred.id,
      verification.authenticationInfo.newCounter,
    );

    const user = await getUserById(cred.userId);

    if (!user) {
      return json(res, 500, {
        error: "user missing",
      });
    }

    if (user.disabled) {
      return json(res, 403, {
        error: "this account has been disabled",
      });
    }

    json(
      res,
      200,
      {
        user: {
          id: user.id,
          name: user.name,
          admin: isAdmin(user),
        },
      },
      {
        "Set-Cookie": sessionCookie(user),
      },
    );
  },

  /* ---------- logout ---------- */

  "POST /api/logout": async (req, res) =>
    json(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie": clearCookie,
      },
    ),

  "POST /api/logout/all": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    const nextVersion = sessionVersion(user) + 1;

    await updateUserFields(user.id, {
      sv: nextVersion,
    });

    json(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie": clearCookie,
      },
    );
  },

  /* ---------- user state ---------- */

  "GET /api/data": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    const state = await getUserState(user.id);

    json(res, 200, {
      state,
    });
  },

  "PUT /api/data": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    const body = await readBody(req);

    if (!body.state || typeof body.state !== "object") {
      return json(res, 400, {
        error: "state required",
      });
    }

    /*
     * In-progress workouts remain device-local.
     */
    delete body.state.active;

    await saveUserState(user.id, body.state);

    json(res, 200, {
      ok: true,
      ts: body.state._ts || null,
    });
  },

  /* ---------- push ---------- */

  "GET /api/push/public-key": async (req, res) =>
    json(res, 200, {
      key: VAPID_PUBLIC_KEY,
    }),

  "POST /api/push/subscribe": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    const body = await readBody(req);

    const sub = body.subscription;

    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return json(res, 400, {
        error: "invalid subscription",
      });
    }

    await upsertSubscription({
      userId: user.id,
      endpoint: sub.endpoint,
      keys: sub.keys,
      created: new Date().toISOString(),
    });

    json(res, 200, {
      ok: true,
    });
  },

  "POST /api/push/unsubscribe": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    const body = await readBody(req);

    await removeSubscription(user.id, body.endpoint);

    json(res, 200, {
      ok: true,
    });
  },

  "POST /api/push/test": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    await sendPush(user.id, {
      title: "openGym",
      body: "Test notification ✅ — this is what alerts look like.",
      tag: "test",
    });

    json(res, 200, {
      ok: true,
    });
  },

  "POST /api/push/rest-timer": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    const body = await readBody(req);

    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));

    if (!sec) {
      return json(res, 400, {
        error: "seconds required",
      });
    }

    scheduleRestTimer(user.id, sec);

    json(res, 200, {
      ok: true,
    });
  },

  "POST /api/push/rest-timer/cancel": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    cancelRestTimer(user.id);

    json(res, 200, {
      ok: true,
    });
  },

  /* ---------- live workout presence ---------- */

  "POST /api/activity": async (req, res) => {
    const user = await readSession(req);

    if (!user) {
      return json(res, 401, {
        error: "not signed in",
      });
    }

    const body = await readBody(req);

    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || "").slice(0, 60),

        exIdx: +body.exIdx || 0,

        exTotal: +body.exTotal || 0,

        setsDone: +body.setsDone || 0,

        setsTotal: +body.setsTotal || 0,

        startedAt: +body.startedAt || Date.now(),

        updatedAt: Date.now(),
      });
    } else {
      presence.delete(user.id);
    }

    json(res, 200, {
      ok: true,
    });
  },

  /* ---------- admin dashboard ---------- */

  "GET /api/admin/users": async (req, res) => {
    if (!(await requireAdmin(req, res))) {
      return;
    }

    const users = await getUsers();

    const rows = await Promise.all(
      users.map(async (user) => {
        const S = (await getUserState(user.id)) || {};

        const workouts = S.workouts || [];

        const last = workouts[workouts.length - 1];

        return {
          id: user.id,
          name: user.name,

          created: user.created || null,

          disabled: !!user.disabled,

          admin: isAdmin(user),

          invitedBy: user.invitedBy || null,

          workouts: workouts.length,

          lastWorkout: last ? last.d : null,

          lastSync: S._ts || null,

          hasPush: await hasSubscription(user.id),

          live: livePresence(user.id),
        };
      }),
    );

    json(res, 200, {
      users: rows,
      invite_only: INVITE_ONLY,
      now: Date.now(),
    });
  },

  /* ---------- admin: user detail ---------- */

  "GET /api/admin/user": async (req, res) => {
    if (!(await requireAdmin(req, res))) {
      return;
    }

    const id = new URL(req.url, "http://x").searchParams.get("id");

    const user = await getUserById(id);

    if (!user) {
      return json(res, 404, {
        error: "no such user",
      });
    }

    const S = (await getUserState(user.id)) || {};

    json(res, 200, {
      user: {
        id: user.id,
        name: user.name,
        created: user.created || null,

        disabled: !!user.disabled,

        admin: isAdmin(user),

        invitedBy: user.invitedBy || null,
      },

      unit: S.unit || "kg",

      lastSync: S._ts || null,

      routines: (S.routines || []).map((r) => ({
        id: r.id,
        name: r.name,
        emoji: r.emoji,
        count: (r.ex || []).length,
      })),

      bodyweight: S.bodyweight || [],

      workouts: (S.workouts || []).slice().reverse(),
    });
  },

  /* ---------- admin: disable user ---------- */

  "POST /api/admin/user/disable": async (req, res) => {
    if (!(await requireAdmin(req, res))) {
      return;
    }

    const body = await readBody(req);

    const user = await getUserById(body.id);

    if (!user) {
      return json(res, 404, {
        error: "no such user",
      });
    }

    if (isAdmin(user)) {
      return json(res, 400, {
        error: "cannot disable an admin",
      });
    }

    const disabled = !!body.disabled;

    await updateUserFields(user.id, {
      disabled,
    });

    if (disabled) {
      presence.delete(user.id);
    }

    json(res, 200, {
      ok: true,
      id: user.id,
      disabled,
    });
  },

  /* ---------- admin: invites ---------- */

  "GET /api/admin/invites": async (req, res) => {
    if (!(await requireAdmin(req, res))) {
      return;
    }

    const invites = await getInvites();

    const users = await getUsers();

    const userMap = new Map(users.map((user) => [user.id, user]));

    const result = invites.map((invite) => ({
      ...invite,

      usedByName: invite.usedBy
        ? (userMap.get(invite.usedBy) || {}).name || null
        : null,
    }));

    json(res, 200, {
      invites: result,
      invite_only: INVITE_ONLY,
    });
  },

  "POST /api/admin/invites/new": async (req, res) => {
    const admin = await requireAdmin(req, res);

    if (!admin) {
      return;
    }

    const body = await readBody(req);

    let code;

    do {
      code = crypto.randomBytes(8).toString("hex").toUpperCase();
    } while (await getInviteByCode(code));

    const invite = {
      code,

      note: String(body.note || "").slice(0, 60),

      createdBy: admin.id,

      created: new Date().toISOString(),
    };

    await createInvite(invite);

    json(res, 200, {
      invite,
    });
  },

  "POST /api/admin/invites/revoke": async (req, res) => {
    if (!(await requireAdmin(req, res))) {
      return;
    }

    const body = await readBody(req);

    const code = String(body.code || "").toUpperCase();

    const invite = await getInviteByCode(code);

    if (!invite) {
      return json(res, 404, {
        error: "no such code",
      });
    }

    if (invite.usedBy) {
      return json(res, 400, {
        error: "already used — cannot revoke",
      });
    }

    await deleteInvite(invite.code);

    json(res, 200, {
      ok: true,
    });
  },
};

/* ---------- startup / shutdown ---------- */

async function start() {
  try {
    await initStorage();

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");

      const key = req.method + " " + url.pathname;

      const handler = routes[key];

      if (!handler) {
        return json(res, 404, {
          error: "not found",
        });
      }

      try {
        await handler(req, res);
      } catch (e) {
        console.error(key, e);

        if (!res.headersSent) {
          json(res, 500, {
            error: "server error",
          });
        }
      }
    });

    const shutdown = async (signal) => {
      console.log(`${signal} received — shutting down`);

      server.close(async () => {
        try {
          await closeStorage();
        } finally {
          process.exit(0);
        }
      });
    };

    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    process.on("SIGINT", () => void shutdown("SIGINT"));

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`gym-api on :${PORT} ` + `(rpID=${RP_ID}, origin=${ORIGIN})`);
    });
  } catch (e) {
    console.error("failed to start API", e);

    process.exit(1);
  }
}

start();
