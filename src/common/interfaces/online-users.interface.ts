export interface OnlineUser {
  id: string;
  name: string;
  level: number;
  levelName: string; // 'Adm', 'Mod', 'Reg', etc.
  presence: 'active' | 'idle';
  presenceTime: number;
  picture: string;
  profileUrl?: string;
}

export interface OnlineUsersResponse {
  users: OnlineUser[];
  guestCount: number;
  totalCount: number;
}