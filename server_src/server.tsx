const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  const filePath = path === "/" ? "./dist/index.html" : `./dist/${path}`;

  try {
    const file = await Deno.readFile(filePath);
    const extension = filePath.substring(filePath.lastIndexOf("."));
    const contentType = MIME_TYPES[extension] || "text/plain";

    return new Response(file, {
      headers: {
        "content-type": contentType
        // "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
});
