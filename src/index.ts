import app from "./app.ts";
import "./workers/email.worker.ts";

const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`The app is running on port ${port}`);
});
