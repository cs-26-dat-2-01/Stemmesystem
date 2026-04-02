import { Hono } from "@hono/hono";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};

const router = new Hono();

router.get("/", async (c) => {
  const file = await Deno.readFile("./dist/index.html");
  return c.body(file);
});

router.get("/assets/*", async (c) => {
  const path = new URL(c.req.url).pathname;

  // Sanitize URL path as only the directory "dist" is the only directory to be publicly served.
  // Deno premisions should also catch any attempts to reach any top level directory outside of "dist"
  const filePath = `./dist/${path}`;

  try {
    const file = await Deno.readFile(filePath);
    const extension = filePath.substring(filePath.lastIndexOf("."));
    const contentType = MIME_TYPES[extension] || "text/plain";

    return new Response(file, {
      headers: {
        "content-type": contentType,
        // "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
});

router.get("/", async (c) => {
  const file = await Deno.readFile("./dist/index.html");
  return c.body(file);
});

router.get("/api/:a/:b", async (c) => {
  const a = c.req.param("a");
  const b = c.req.param("b");
  console.log(a, b);
  return new Response("API Route not found", { status: 404 });
});

Deno.serve(router.fetch);
