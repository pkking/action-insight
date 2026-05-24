import { main } from './rebuild-pr-artifacts.ts';

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
