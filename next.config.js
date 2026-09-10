/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ably's bundled build trips Next's swc client parser ("'super' outside a method").
  // Externalize it so server routes require it via Node (no webpack parse); the client
  // loads Ably from its official CDN instead of importing it (see PitChat.jsx).
  // 'ably' — bundled build trips Next's swc client parser; require it via Node instead.
  // 'unpdf' — serverless pdfjs build used by the congress House PTR parser; keep it external.
  serverExternalPackages: ['ably', 'unpdf'],
};

export default nextConfig;
