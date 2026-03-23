import jwt from 'jsonwebtoken';
export const auth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.log(`[AUTH] 401: No token provided for ${req.originalUrl}`);
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key-change-this");
        req.user = {
            id: decoded.id,
            email: decoded.email,
            type: decoded.type
        };
        next();
    }
    catch (err) {
        console.log(`[AUTH] 401: Invalid token for ${req.originalUrl}. Error: ${err.message}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};
