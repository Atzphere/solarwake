"""Year-round interpolation for user-defined solar schedule control points.

Control points are anchored to month/day, not to a particular calendar year.
The interpolation is periodic across Dec 31 -> Jan 1 and is monotonic between
adjacent knots (no unexpected overshoot from ordinary cubic splines).
"""
from __future__ import annotations

from datetime import date
from math import copysign


def day_number(day: date) -> float:
    """Map dates onto a common 365-day cycle; Feb 29 falls halfway to Mar 1."""
    if day.month == 2 and day.day == 29:
        return float(date(2001, 2, 28).timetuple().tm_yday - 1) + 0.5
    return float(date(2001, day.month, day.day).timetuple().tm_yday - 1)


def interpolate(points: list[tuple[float, float]], day: date) -> float:
    """Periodic PCHIP: smooth at knots and preserves each interval's bounds.

    `points` is [(365-day-axis position, numeric value), ...], sorted by x.
    """
    if len(points) < 2:
        raise ValueError("At least two seasonal control points required")
    pts = sorted(points)
    n = len(pts)
    x = day_number(day)
    if x < pts[0][0]:
        x += 365
    extended = pts + [(pts[0][0] + 365, pts[0][1])]

    def periodic_index(k: int) -> tuple[float, float]:
        q, r = divmod(k, n)
        return pts[r][0] + 365 * q, pts[r][1]

    def slope(k: int) -> float:
        x0,y0 = periodic_index(k-1)
        x1,y1 = periodic_index(k)
        x2,y2 = periodic_index(k+1)
        h0,h1 = x1-x0,x2-x1
        d0,d1 = (y1-y0)/h0, (y2-y1)/h1
        if d0*d1 <= 0:
            return 0.0
        w0,w1 = 2*h1+h0, h1+2*h0
        return (w0+w1)/(w0/d0+w1/d1)

    for i in range(n):
        xa,ya = extended[i]
        xb,yb = extended[i+1]
        if xa <= x <= xb:
            h = xb-xa
            t = (x-xa)/h
            m0,m1 = slope(i),slope(i+1)
            value = ((2*t**3-3*t**2+1)*ya
                     + (t**3-2*t**2+t)*h*m0
                     + (-2*t**3+3*t**2)*yb
                     + (t**3-t**2)*h*m1)
            # Rounding errors must not give users a more extreme value than
            # either endpoint; PCHIP theoretically stays within these limits.
            return max(min(ya,yb), min(max(ya,yb), value))
    raise AssertionError("Periodic curve interval not found")
