declare global {
    namespace Express {
      interface Request {
        requestTime?: number;
        user?: string | import("jsonwebtoken").JwtPayload;
      }
    }
  }
  
  export {};