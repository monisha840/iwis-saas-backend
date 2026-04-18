// Helper for selecting and flattening the display name/avatar of a User.
// The User model has no `name` / `avatar` columns — those live on the
// role-specific sub-profile (Doctor / Therapist / Patient / Pharmacist).

export const userNameSelect = {
  id: true,
  role: true,
  // Patient has no profilePhoto column, only fullName.
  doctor: { select: { fullName: true, profilePhoto: true } },
  therapist: { select: { fullName: true, profilePhoto: true } },
  patient: { select: { fullName: true } },
  pharmacist: { select: { fullName: true, profilePhoto: true } },
};

export const flattenUserName = (user) => {
  if (!user) return user;
  const sub =
    user.doctor ?? user.therapist ?? user.patient ?? user.pharmacist ?? null;
  const { doctor, therapist, patient, pharmacist, ...rest } = user;
  return {
    ...rest,
    name: sub?.fullName ?? null,
    avatar: sub?.profilePhoto ?? null,
  };
};
