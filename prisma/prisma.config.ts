import { defineConfig } from '@prisma/client';

export default defineConfig({
  datasource: {
    db: {
      provider: 'postgresql',
      url: 'env:DATABASE_URL',
    },
  },
});
