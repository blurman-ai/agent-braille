#!/usr/bin/env node
// Tiny backend and static server for the example: node server.mjs <port> [dist]. Data lives in memory.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [port, dist = "dist"] = process.argv.slice(2);
const people = [];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/people") {
    if (req.method === "GET") return setTimeout(() => json(200, { items: people }), 40);
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const person = JSON.parse(body);
      if (person.name === "boom") return json(422, { detail: { code: "name_rejected" } });
      people.push({ ...person, id: String(people.length + 1) });
      return json(200, { ok: true });
    });
    return undefined;
  }
  const direct = path.join(dist, url.pathname);
  const file = path.extname(url.pathname) && fs.existsSync(direct) ? direct : path.join(dist, "index.html");
  res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
  return res.end(fs.readFileSync(file));
}).listen(Number(port), "127.0.0.1");
