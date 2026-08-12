import { runDoctor, formatDoctorReport } from '../tools/doctor.js';

runDoctor()
  .then((report) => {
    console.log(formatDoctorReport(report));
    if (!report.envOk || !report.loggedIn || report.refreshCheckOk === false) {
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error(`[doctor] 실행 실패: ${(err as Error).message}`);
    process.exitCode = 1;
  });
