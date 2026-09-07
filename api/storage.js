// api/storage.js
//
// MongoDB persistence layer for openGym.
//
// This replaces the current JSON-file persistence:
//
//   /data/db.json
//   /data/state-<uid>.json
//
// Collections:
//
//   users
//   credentials
//   subscriptions
//   invites
//   states
//
// Environment variables:
//
//   MONGODB_URI  - MongoDB connection string
//   MONGODB_DB   - database name (defaults to "opengym")

import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "opengym";

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI environment variable is required");
}

let client = null;
let database = null;
let initialized = false;

/**
 * Connect to MongoDB and create the indexes we need.
 * Safe to call more than once.
 */
export async function initStorage() {
  if (initialized) return;

  client = new MongoClient(MONGODB_URI);
  await client.connect();

  database = client.db(MONGODB_DB);

  await Promise.all([
    database.collection("users").createIndex({ id: 1 }, { unique: true }),

    database.collection("credentials").createIndex({ userId: 1 }),

    database.collection("subscriptions").createIndex({ userId: 1 }),

    database.collection("invites").createIndex({ code: 1 }, { unique: true }),
  ]);

  initialized = true;

  console.log(`MongoDB connected: ${MONGODB_DB}`);
}

function requireDatabase() {
  if (!database) {
    throw new Error("MongoDB storage has not been initialized");
  }

  return database;
}

function usersCollection() {
  return requireDatabase().collection("users");
}

function credentialsCollection() {
  return requireDatabase().collection("credentials");
}

function subscriptionsCollection() {
  return requireDatabase().collection("subscriptions");
}

function invitesCollection() {
  return requireDatabase().collection("invites");
}

function statesCollection() {
  return requireDatabase().collection("states");
}

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Return all users.
 */
export async function getUsers() {
  return usersCollection().find({}).project({ _id: 0 }).toArray();
}

/**
 * Return the number of users.
 */
export async function countUsers() {
  return usersCollection().countDocuments();
}

/**
 * Find a user by openGym uid.
 */
export async function getUserById(uid) {
  return usersCollection().findOne({ id: uid }, { projection: { _id: 0 } });
}

/**
 * Create a new user.
 */
export async function createUser(user) {
  const document = {
    ...user,
    id: user.id,
  };

  await usersCollection().insertOne(document);

  return document;
}

/**
 * Update a user.
 *
 * `user.id` remains the immutable openGym identifier.
 */
export async function updateUser(user) {
  if (!user?.id) {
    throw new Error("Cannot update user without id");
  }

  const { id, ...changes } = user;

  await usersCollection().updateOne(
    { id },
    { $set: changes },
    { upsert: false },
  );

  return getUserById(id);
}

/**
 * Update selected fields without first loading the user.
 */
export async function updateUserFields(uid, changes) {
  if (!uid) {
    throw new Error("Cannot update user without id");
  }

  await usersCollection().updateOne(
    { id: uid },
    { $set: changes },
    { upsert: false },
  );

  return getUserById(uid);
}

/* -------------------------------------------------------------------------- */
/* WebAuthn credentials                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Find a WebAuthn credential by its credential ID.
 *
 * The current openGym implementation stores credential.id directly,
 * so we use it as MongoDB's _id.
 */
export async function getCredentialById(credentialId) {
  if (!credentialId) return null;

  const credential = await credentialsCollection().findOne({
    _id: credentialId,
  });

  if (!credential) return null;

  return {
    id: credential._id,
    userId: credential.userId,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports || [],
  };
}

/**
 * Return all credentials belonging to a user.
 */
export async function getCredentialsByUserId(userId) {
  const credentials = await credentialsCollection().find({ userId }).toArray();

  return credentials.map((credential) => ({
    id: credential._id,
    userId: credential.userId,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports || [],
  }));
}

/**
 * Check whether a credential already exists.
 */
export async function credentialExists(credentialId) {
  if (!credentialId) return false;

  const count = await credentialsCollection().countDocuments({
    _id: credentialId,
  });

  return count > 0;
}

/**
 * Store a new WebAuthn credential.
 */
export async function createCredential(credential) {
  await credentialsCollection().insertOne({
    _id: credential.id,
    userId: credential.userId,
    publicKey: credential.publicKey,
    counter: credential.counter || 0,
    transports: credential.transports || [],
  });
}

/**
 * Update the authentication counter after a successful passkey login.
 */
export async function updateCredentialCounter(credentialId, counter) {
  await credentialsCollection().updateOne(
    { _id: credentialId },
    { $set: { counter } },
  );
}

/* -------------------------------------------------------------------------- */
/* Push subscriptions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Return all push subscriptions for a user.
 */
export async function getSubscriptionsByUserId(userId) {
  const subscriptions = await subscriptionsCollection()
    .find({ userId })
    .toArray();

  return subscriptions.map((subscription) => ({
    userId: subscription.userId,
    endpoint: subscription._id,
    keys: subscription.keys,
    created: subscription.created,
  }));
}

/**
 * Store/update a push subscription.
 *
 * The current application treats endpoint as unique, so we use endpoint
 * as MongoDB's _id too.
 */
export async function upsertSubscription(subscription) {
  await subscriptionsCollection().replaceOne(
    { _id: subscription.endpoint },
    {
      _id: subscription.endpoint,
      userId: subscription.userId,
      keys: subscription.keys,
      created: subscription.created || new Date().toISOString(),
    },
    { upsert: true },
  );
}

/**
 * Remove one push subscription.
 */
export async function removeSubscription(userId, endpoint) {
  await subscriptionsCollection().deleteOne({
    _id: endpoint,
    userId,
  });
}

/**
 * Return whether a user currently has at least one push subscription.
 */
export async function hasSubscription(userId) {
  const subscription = await subscriptionsCollection().findOne(
    { userId },
    { projection: { _id: 1 } },
  );

  return !!subscription;
}

/* -------------------------------------------------------------------------- */
/* Invites                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Return all invite records.
 */
export async function getInvites() {
  return invitesCollection().find({}).project({ _id: 0 }).toArray();
}

/**
 * Find an invite by its code.
 */
export async function getInviteByCode(code) {
  if (!code) return null;

  return invitesCollection().findOne({ code }, { projection: { _id: 0 } });
}

/**
 * Create an invite.
 *
 * The code itself is the unique identifier.
 */
export async function createInvite(invite) {
  await invitesCollection().insertOne({
    _id: invite.code,
    ...invite,
  });

  return invite;
}

/**
 * Update an existing invite.
 */
export async function updateInvite(invite) {
  if (!invite?.code) {
    throw new Error("Cannot update invite without code");
  }

  const { code, ...changes } = invite;

  await invitesCollection().updateOne({ _id: code }, { $set: changes });

  return getInviteByCode(code);
}

/**
 * Delete/revoke an unused invite.
 */
export async function deleteInvite(code) {
  await invitesCollection().deleteOne({
    _id: code,
  });
}

/* -------------------------------------------------------------------------- */
/* Per-user application state                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Return a user's complete openGym state.
 *
 * This is intentionally kept as one MongoDB document because the existing
 * application already treats a user's state as one JSON object.
 */
export async function getUserState(userId) {
  const document = await statesCollection().findOne({
    _id: userId,
  });

  return document?.state ?? null;
}

/**
 * Save/replace a user's complete openGym state.
 */
export async function saveUserState(userId, state) {
  if (!userId) {
    throw new Error("Cannot save state without user id");
  }

  await statesCollection().replaceOne(
    { _id: userId },
    {
      _id: userId,
      state,
    },
    { upsert: true },
  );
}

/**
 * Delete a user's state.
 *
 * Not currently needed by the API, but useful for future account deletion.
 */
export async function deleteUserState(userId) {
  await statesCollection().deleteOne({
    _id: userId,
  });
}

/* -------------------------------------------------------------------------- */
/* Graceful shutdown                                                          */
/* -------------------------------------------------------------------------- */

export async function closeStorage() {
  if (!client) return;

  await client.close();

  client = null;
  database = null;
  initialized = false;

  console.log("MongoDB connection closed");
}
