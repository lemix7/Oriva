import express, { type Response, type Request, type Express } from "express";
import pool from "../pool/pooler.ts";
import * as db from "../controllers/users.controller.ts";

const router = express.Router();

// router.get("/", async (req: Request, res: Response) => {
//   try {
//     const results = await pool.query("SELECT * FROM users ORDER BY id ASC");
//     res.status(200).json(results.rows);
//   } catch (error) {
//     throw error;
//   }
// });

// router.get("/:user_id", async (req: Request, res: Response) => {
//   const id = Number(req.params.user_id);
//   try {
//     const results = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
//     res.status(200).json(results.rows);
//   } catch (error) {
//     throw error;
//   }
// });

// router.post("/", async (req: Request, res: Response) => {
//   const { name, email } = req.body;
//   try {
//     const results = await pool.query(
//       "INSERT INTO users (name , email) VALUES ($1, $2) RETURNING *",
//       [name, email],
//     );
//     res.status(200).send(`User added with ID: ${results.rows[0].id}`);
//   } catch (error) {
//     throw error;
//   }
// });

// router.put("/:user_id", async (req: Request, res: Response) => {
//   const id = Number(req.params.user_id);
//   const { name, email } = req.body;
//   try {
//     const results = await pool.query(
//       "UPDATE users SET name = $1 , email = $2 WHERE id = $3",
//       [name, email, id],
//     );
//     res.status(200).send(`User modified with ID: ${id}`);
//   } catch (error) {
//     throw error;
//   }
// });

// router.delete("/:user_id", async (req: Request, res: Response) => {
//   const id = Number(req.params.user_id);
//   try {
//     const results = await pool.query("DELETE FROM users WHERE id = $1 ", [id]);
//     res.status(200).send(`User deleted with ID: ${id}`);
//   } catch (error) {
//     throw error;
//   }
// });

router.get("/", db.getUsers);
router.get("/:user_id", db.getUserById);
router.post("/", db.createUser);
router.put("/:user_id", db.updateUser);
router.delete("/:user_id", db.deleteUser);

export default router;
