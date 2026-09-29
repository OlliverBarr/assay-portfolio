import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import {
  ANALYTICS_FEATURE_KEYS,
  getFeatureQuartiles,
  getFunnelSummary,
  getJudgmentQuality,
  getLaunchCadence,
  getRecentAlertOutcomes,
  getScorePrecision,
  getSurvivalByHorizon,
  type AnalyticsFeatureKey,
  type Db
} from "@assay/database";

export interface DashboardAppDeps {
  readonly db: Db;
  readonly chainId: number;
}

const ALLOWED_HORIZONS = [24, 72, 168] as const;
type AllowedHorizon = (typeof ALLOWED_HORIZONS)[number];

function isAnalyticsFeatureKey(value: string): value is AnalyticsFeatureKey {
  return (ANALYTICS_FEATURE_KEYS as readonly string[]).includes(value);
}

/**
 * Parses an optional integer query param, clamping in-range values into
 * [min, max] and falling back to `fallback` when unset. Returns `undefined`
 * only when the raw value fails to parse as a finite number at all: a
 * non-numeric input is a 400, while an out-of-range one is silently
 * clamped for a friendlier UX.
 */
function parseClampedIntParam(
  raw: string | undefined,
  options: { readonly fallback: number; readonly min: number; readonly max: number }
): number | undefined {
  if (raw === undefined) return options.fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(options.max, Math.max(options.min, Math.trunc(value)));
}

function parseHorizonParam(raw: string | undefined): AllowedHorizon | undefined {
  if (raw === undefined) return 72;
  const value = Number(raw);
  return (ALLOWED_HORIZONS as readonly number[]).includes(value)
    ? (value as AllowedHorizon)
    : undefined;
}

// chart.js's package.json "exports" map only exposes "." / "./auto" /
// "./helpers"; the UMD bundle at dist/chart.umd.js is not a resolvable
// subpath. Resolve the bare specifier (which the exports map does allow)
// and derive the dist directory from it instead.
const chartDistDir = dirname(createRequire(import.meta.url).resolve("chart.js"));
const chartUmdFile = join(chartDistDir, "chart.umd.js");
if (!existsSync(chartUmdFile)) {
  throw new Error(
    `chart.js UMD bundle not found at "${chartUmdFile}"; check the installed chart.js version's dist layout`
  );
}

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

/**
 * Read-only analytics dashboard over the existing Postgres data. Every
 * route delegates straight to the SQL aggregations in
 * `@assay/database`'s analytics module (packages own the queries; apps
 * never open their own connections). No mutation routes exist.
 */
export function buildDashboardApp(deps: DashboardAppDeps): FastifyInstance {
  const { db, chainId } = deps;
  const app = Fastify();

  // Single registration with both roots: @fastify/static tries publicDir
  // first, then chartDistDir, so "/" resolves index.html and
  // "/chart.umd.js" resolves the vendored UMD bundle with no CDN and no
  // vendored copy in git.
  void app.register(fastifyStatic, {
    root: [publicDir, chartDistDir],
    prefix: "/"
  });

  app.get("/api/funnel", async () => getFunnelSummary(db, chainId));

  app.get<{ Querystring: { days?: string } }>(
    "/api/launches",
    async (request, reply) => {
      const days = parseClampedIntParam(request.query.days, {
        fallback: 30,
        min: 1,
        max: 90
      });
      if (days === undefined) {
        return reply.code(400).send({ error: `"days" must be a number` });
      }
      return getLaunchCadence(db, chainId, days);
    }
  );

  app.get<{ Querystring: { horizon?: string } }>(
    "/api/precision",
    async (request, reply) => {
      const horizon = parseHorizonParam(request.query.horizon);
      if (horizon === undefined) {
        return reply
          .code(400)
          .send({ error: `"horizon" must be one of ${ALLOWED_HORIZONS.join(", ")}` });
      }
      return getScorePrecision(db, chainId, horizon);
    }
  );

  app.get<{ Querystring: { feature?: string; horizon?: string } }>(
    "/api/quartiles",
    async (request, reply) => {
      const featureRaw = request.query.feature;
      if (featureRaw === undefined || !isAnalyticsFeatureKey(featureRaw)) {
        return reply.code(400).send({
          error: `"feature" must be one of ${ANALYTICS_FEATURE_KEYS.join(", ")}`
        });
      }
      const horizon = parseHorizonParam(request.query.horizon);
      if (horizon === undefined) {
        return reply
          .code(400)
          .send({ error: `"horizon" must be one of ${ALLOWED_HORIZONS.join(", ")}` });
      }
      return getFeatureQuartiles(db, chainId, horizon, featureRaw);
    }
  );

  app.get("/api/survival", async () => getSurvivalByHorizon(db, chainId));

  app.get<{ Querystring: { limit?: string } }>(
    "/api/alerts",
    async (request, reply) => {
      const limit = parseClampedIntParam(request.query.limit, {
        fallback: 50,
        min: 1,
        max: 200
      });
      if (limit === undefined) {
        return reply.code(400).send({ error: `"limit" must be a number` });
      }
      return getRecentAlertOutcomes(db, chainId, limit);
    }
  );

  app.get("/api/judgment", async () => getJudgmentQuality(db, chainId));

  return app;
}
