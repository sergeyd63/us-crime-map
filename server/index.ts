import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OfficialApiError, getCountyStats, getSourceMeta, getStateStats } from "./fbiClient.js";

const app = express();
const port = Number(process.env.PORT || "5174");
const dirname = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(dirname, "..", "dist");

const asyncRoute =
  (handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next);
  };

const shouldRefresh = (request: Request) => request.query.refresh === "1" || request.query.refresh === "true";

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    ...getSourceMeta()
  });
});

app.get(
  "/api/crime/states",
  asyncRoute(async (request, response) => {
    response.json(await getStateStats(shouldRefresh(request)));
  })
);

app.get(
  "/api/crime/states/:stateAbbr/counties",
  asyncRoute(async (request, response) => {
    response.json(await getCountyStats(request.params.stateAbbr, shouldRefresh(request)));
  })
);

app.use(express.static(staticRoot));

app.get("*", (_request, response, next) => {
  response.sendFile(path.join(staticRoot, "index.html"), (error) => {
    if (error) {
      next();
    }
  });
});

app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof OfficialApiError) {
    response.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
      error: error.message,
      sourceUrl: error.url,
      ...getSourceMeta()
    });
    return;
  }

  response.status(500).json({
    error: error.message || "Unexpected server error"
  });
});

app.listen(port, () => {
  console.log(`Crime map API listening on http://localhost:${port}`);
});
