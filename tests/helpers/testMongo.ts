/**
 * Where tests that write to MongoDB may do so.
 *
 * MONGODB_TEST_URI, else MONGODB_URI, else jrok-test-mongo
 * (docker run -d --rm -p 127.0.0.1:27018:27017 --name jrok-test-mongo mongo:7),
 * and only when the database that URI names starts with "jrok_test". These
 * tests empty whole collections; they once emptied the real "jrok" database's
 * certificates on localhost:27017, when jrok ignored the URI's database.
 */
import { uriDatabaseName } from "../../src/utils/mongodb";

export const DEFAULT_TEST_MONGO_URI = "mongodb://127.0.0.1:27018/jrok_test";

export function testMongo(): { uri: string; db: string } | { skip: string } {
  const uri = process.env.MONGODB_TEST_URI || process.env.MONGODB_URI || DEFAULT_TEST_MONGO_URI;
  // The URI alone decides, as the tests connect after deleting MONGODB_DB:
  // MONGODB_DB=jrok_test… must not pass a URI that names "jrok".
  const db = uriDatabaseName(uri);
  if (!db.startsWith("jrok_test")) {
    // The database's name only: the URI may hold a password.
    return { skip: `"${db}" is not a test database. Name one in the URI, e.g. ${DEFAULT_TEST_MONGO_URI}` };
  }
  return { uri, db };
}
