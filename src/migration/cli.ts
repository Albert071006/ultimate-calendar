import { runMigrationCommand } from './command';

try { process.stdout.write(JSON.stringify(runMigrationCommand(process.argv.slice(2)),null,2)+'\n'); }
catch(error) { process.stderr.write((error instanceof Error?error.message:'迁移准备未完成')+'\n');process.exitCode=1; }
