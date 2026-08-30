import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone from the first commit. Next traces only reachable modules, so
  // the artifact is ~60MB against a 600MB tree — and it is the only shape that
  // can be built somewhere other than the 1 vCPU droplet. We build in Actions
  // and rsync, which is why this app never runs `next build` on the box.
  //
  // Never both standalone and `next start`: together Next warns on every start
  // and builds a bundle nothing serves.
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
