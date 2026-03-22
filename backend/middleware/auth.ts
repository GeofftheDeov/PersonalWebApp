import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface AuthRequest extends Request {
    user?: {
        id: string;
        email: string;
        type: string;
    };
}

export const auth = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log(`[AUTH] 401: No token provided for ${req.originalUrl}`);
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this") as any;
        req.user = {
            id: decoded.id,
            email: decoded.email,
            type: decoded.type
        };
        next();
    } catch (err: any) {
        console.log(`[AUTH] 401: Invalid token for ${req.originalUrl}. Error: ${err.message}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};
