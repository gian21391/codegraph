classdef Circle
    properties
        r = 1;
    end
    methods
        function a = area(obj)
            a = pi * obj.r^2;
        end
    end
end
