'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');
const {
  handleBusinessLicenseUpload,
  validateUploadedBusinessLicense,
} = require('../middleware/upload.middleware');
const adminService = require('../services/admin.service');
const storageService = require('../services/storage.service');
const { sanitizeFilename } = require('../utils/file.util');
const { Employer, Agency } = require('../models');
const AppError = require('../errors/AppError');

const router = Router();

// All routes here require a valid JWT with employer or agency role.
router.use(authenticate, authorizeRoles('employer', 'agency'));

/**
 * POST /api/v1/verification/license
 * Upload or re-upload the business license document.
 * Accessible while pending OR rejected — so rejected users can resubmit.
 */
router.post(
  '/license',
  handleBusinessLicenseUpload,
  validateUploadedBusinessLicense,
  async (req, res, next) => {
    try {
      const { safeName } = sanitizeFilename(req.file.originalname);
      const key = `business-licenses/${req.user.id}/${safeName}`;

      const url = await storageService.uploadBuffer(req.file.buffer, key, req.file.mimetype);

      // Save to the correct profile collection
      const Model = req.user.role === 'employer' ? Employer : Agency;
      await Model.findOneAndUpdate({ userId: req.user.id }, { businessLicenseUrl: url });

      return res.status(200).json({ status: 'success', data: { businessLicenseUrl: url } });
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * POST /api/v1/verification/resubmit
 * Rejected employers/agencies reset their status back to 'pending'
 * after re-uploading their documents.
 */
router.post('/resubmit', async (req, res, next) => {
  try {
    // Ensure they have already uploaded a license before resubmitting
    const Model = req.user.role === 'employer' ? Employer : Agency;
    const profile = await Model.findOne({ userId: req.user.id }).select('businessLicenseUrl');
    if (!profile || !profile.businessLicenseUrl) {
      return next(new AppError('Please upload your business license before resubmitting', 400));
    }

    const user = await adminService.resubmitVerification(req.user.id);
    return res.status(200).json({ status: 'success', data: { user } });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/v1/verification/status
 * Returns the current verification status and rejection reason for the logged-in user.
 */
router.get('/status', async (req, res, next) => {
  try {
    const { User } = require('../models');
    const user = await User.findById(req.user.id).select('verificationStatus verificationRejectionReason');
    if (!user) return next(new AppError('User not found', 404));

    return res.status(200).json({
      status: 'success',
      data: {
        verificationStatus: user.verificationStatus,
        verificationRejectionReason: user.verificationRejectionReason,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
