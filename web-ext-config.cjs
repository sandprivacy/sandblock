// Le banc de test et la documentation ne font pas partie de l'extension
// livrÃ©e. Les exclure Ã©vite aussi que le validateur AMO signale le
// `new Function(...)` des tests, qui n'existe que cÃ´tÃ© Node.
module.exports = {
  ignoreFiles: [
    'test/**',
    'store-assets/**',
    'web-ext-config.cjs',
    'PUBLICATION.md',
    '**/*.png.md',
  ],
};

