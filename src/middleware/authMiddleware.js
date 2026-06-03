export function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ message: "Unauthorized. Please log in." })
    }
    next()
}

export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ message: "Unauthorized. Please log in." })
        }
        if (!roles.includes(req.session.user.role)) {
            return res.status(403).json({ message: "Forbidden. Insufficient permissions." })
        }
        next()
    }
}

export const requirePrimaryOwner = requireRole("owner")
export const requireOwnerOrCoOwner = requireRole("owner", "co_owner")
