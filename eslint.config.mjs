import powerbiVisuals from "eslint-plugin-powerbi-visuals";

export default [
    { ignores: ["node_modules/**", "dist/**", ".tmp/**", ".tmpinspect/**", "tests/**", "scripts/**", "assets/**", "eslint.config.mjs"] },
    powerbiVisuals.configs.recommended,
];
